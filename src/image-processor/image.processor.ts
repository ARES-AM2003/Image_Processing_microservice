import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import sharp from "sharp";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import * as https from "https";
import * as os from "os";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PassThrough, Readable } from "stream";
const decode = require("heic-decode");
const execAsync = promisify(exec);

@Processor("image-processing", {
  concurrency: 1, // Process one job at a time to manage memory
  lockDuration: 300000, // 5 minutes lock duration for long-running jobs
  lockRenewTime: 15000, // Renew lock every 15 seconds
})
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);
  private readonly s3Client: S3Client;
  private readonly memoryThreshold = Math.floor(os.totalmem() * 0.3); // 30% of total RAM

  private readonly maxPixels = 50 * 1024 * 1024; // 50MP limit for safety
  private processedCount = 0;
  private skippedCount = 0;
  private totalProcessingTime = 0;
  private activeJobs = new Set<string>();

  // Supported image formats
  // Note: RAW formats support depends on libvips/Sharp compilation and system libraries
  private readonly supportedImageFormats = [
    // Standard web formats
    "jpg",
    "jpeg",
    "png",
    "gif",
    "bmp",
    "tiff",
    "tif",
    "webp",
    "svg",
    "ico",

    // Modern formats
    "heic", // Apple HEIC format
    "heif", // High Efficiency Image Format
    "avif", // AV1 Image File Format

    // RAW camera formats (support may vary)
    "raw", // Generic RAW
    "cr2", // Canon RAW v2
    "cr3", // Canon RAW v3
    "nef", // Nikon Electronic Format
    "arw", // Sony RAW
    "dng", // Adobe Digital Negative
    "orf", // Olympus RAW Format
    "rw2", // Panasonic RAW
    "pef", // Pentax Electronic Format
    "srw", // Samsung RAW
    "raf", // Fujifilm RAW
    "3fr", // Hasselblad 3F RAW
    "fff", // Imacon/Hasselblad Flexible File Format
    "dcr", // Kodak RAW
    "kdc", // Kodak Digital Camera RAW
    "srf", // Sony RAW Format
    "x3f", // Sigma RAW
    "mef", // Mamiya Electronic Format
    "mos", // Leaf RAW
    "mrw", // Minolta RAW
    "nrw", // Nikon RAW
    "rw1", // Panasonic RAW
    "rwl", // Leica RAW
    "iiq", // Phase One RAW
    "k25", // Kodak DC25 RAW
    "crw", // Canon RAW (older)
    "erf", // Epson RAW Format
    "sr2", // Sony RAW v2
    "rwz", // Rawzor RAW
    "bay", // Casio RAW
    "cap", // Phase One RAW
    "eip", // Enhanced Image Package
    "dcs", // Kodak DCS RAW
    "ptx", // Pentax RAW
    "pcd", // Kodak Photo CD
    "fpx", // FlashPix
  ];

  constructor() {
    super();
    // Production Sharp optimizations
    sharp.cache({ files: 0, items: 0 }); // Disable all caching
    sharp.concurrency(Math.max(1, os.cpus().length)); // Use all CPU cores
    sharp.simd(true); // Enable SIMD acceleration

    // Production S3 client optimizations
    this.s3Client = new S3Client({
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_KEY || "",
      },
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5000,
        socketTimeout: 60000,
        httpsAgent: new https.Agent({
          keepAlive: true,
          maxSockets: 50,
          maxFreeSockets: 10,
        }),
      }),
    });

    // S3 Configuration loaded
  }

  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    this.logger.error(`Worker error: ${error.message}`);
  }

  private async getObjectAsBuffer(bucket: string, key: string): Promise<Buffer> {
    const result = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (!result.Body) {
      throw new Error(`Empty S3 body for ${bucket}/${key}`);
    }

    return this.bodyToBuffer(result.Body);
  }

  private async getObjectStream(bucket: string, key: string): Promise<Readable> {
    const result = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (!result.Body) {
      throw new Error(`Empty S3 body for ${bucket}/${key}`);
    }

    const body = result.Body as any;
    if (typeof body.pipe === "function") {
      return body as Readable;
    }

    const buffer = await this.bodyToBuffer(result.Body);
    return Readable.from(buffer);
  }

  private async bodyToBuffer(body: any): Promise<Buffer> {
    if (Buffer.isBuffer(body)) {
      return body;
    }

    if (body instanceof Uint8Array) {
      return Buffer.from(body);
    }

    if (typeof body?.transformToByteArray === "function") {
      const data = await body.transformToByteArray();
      return Buffer.from(data);
    }

    if (typeof body?.pipe === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of body as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    throw new Error("Unsupported S3 body type");
  }

  /**
   * Check if the file is an image based on S3 content type (production optimized)
   */
  private async isImageFile(bucket: string, key: string): Promise<boolean> {
    try {
      const headObject = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );

      const contentType = headObject.ContentType || "";
      const isImage = contentType.startsWith("image/");

      // Minimal logging for production
      if (!isImage) {
        console.log(`⏭️  Non-image file detected`);
      }

      return isImage;
    } catch (error) {
      // Silent fallback to extension check for performance
      const extension = key.split(".").pop()?.toLowerCase();
      return extension ? this.supportedImageFormats.includes(extension) : false;
    }
  }

  /**
   * Check if the file is HEIC or HEIF format
   */
  private isHeicFormat(key: string): boolean {
    const extension = key.split(".").pop()?.toLowerCase();
    return extension === "heic" || extension === "heif";
  }

  /**
   * Test HEIC/HEIF conversion functionality
   */
  async testHeicConversion(bucket: string, key: string): Promise<any> {
    try {
      console.log(`🧪 Testing HEIC/HEIF conversion...`);

      if (!this.isHeicFormat(key)) {
        throw new Error(`File is not a HEIC/HEIF format`);
      }

      // Validate the HEIC/HEIF file
      const isValid = await this.validateHeicContent(bucket, key);
      if (!isValid) {
        throw new Error(`Invalid HEIC/HEIF file`);
      }

      // Convert to WebP
      const webpKey = await this.convertHeicToWebp(bucket, key);

      // Verify the converted file exists
      const webpExists = await this.fileExists(bucket, webpKey);
      if (!webpExists) {
        throw new Error(`Converted WebP file not found`);
      }

      console.log(`✅ HEIC/HEIF conversion test passed`);

      return {
        success: true,
        originalKey: key,
        convertedKey: webpKey,
        message: "HEIC/HEIF conversion test completed successfully",
      };
    } catch (error) {
      console.error(`❌ HEIC/HEIF conversion test failed:`, error.message);
      return {
        success: false,
        originalKey: key,
        error: error.message,
        message: "HEIC/HEIF conversion test failed",
      };
    }
  }

  /**
   * Check if file exists in S3 bucket
   */
  private async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      // Re-throw other errors (permission issues, etc.)
      throw error;
    }
  }

  /**
   * Validate HEIC/HEIF files using libheif-js
   */
  private async validateHeicContent(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    try {
      console.log(`🔍 Validating HEIC/HEIF format...`);

      // Get object as buffer for libheif validation
      const inputBuffer = await this.getObjectAsBuffer(bucket, key);

      if (!inputBuffer || inputBuffer.length === 0) {
        console.warn(`❌ Empty buffer for HEIC/HEIF file`);
        return false;
      }

      // Check file size before validation
      const fileSizeMB = inputBuffer.length / (1024 * 1024);
      console.log(`📏 HEIC/HEIF file size: ${fileSizeMB.toFixed(2)} MB`);

      // Quick size validation
      if (inputBuffer.length < 1024) {
        return false;
      }

      // Memory-efficient validation
      try {
        // Try smaller buffer for validation to save memory
        const validationBuffer =
          inputBuffer.length > 2 * 1024 * 1024
            ? inputBuffer.slice(0, 2 * 1024 * 1024)
            : inputBuffer;

        const { width, height } = await decode({ buffer: validationBuffer });

        // Check for reasonable dimensions
        if (width > 0 && height > 0 && width * height <= this.maxPixels) {
          return true;
        }
        return false;
      } catch (heicDecodeError) {
        // Fast fallback to Sharp
        try {
          const metadata = await sharp(inputBuffer).metadata();
          return (
            metadata.format !== undefined &&
            (metadata.width || 0) * (metadata.height || 0) <= this.maxPixels
          );
        } catch {
          return false;
        }
      }
    } catch (error) {
      // Check if it's a "file not found" error
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        console.error(`❌ HEIC/HEIF file not found in S3`);
        throw new Error(`HEIC/HEIF file not found in S3`);
      }

      // Check if it's a corruption error that we should skip gracefully
      const errorMessage = error.message || "";
      if (
        errorMessage.includes("bad seek") ||
        errorMessage.includes("Unexpected end of file") ||
        errorMessage.includes("Extent in iloc box") ||
        errorMessage.includes("Invalid input") ||
        errorMessage.includes("compression format has not been built in")
      ) {
        console.warn(
          `⚠️  HEIC/HEIF file appears corrupted or unsupported, skipping`,
        );
        console.warn(`   Corruption details: ${errorMessage}`);
        return false;
      }

      console.warn(`❌ HEIC/HEIF validation failed: ${error.message}`);
      console.warn(`   Error code: ${error.code || "unknown"}`);
      console.warn(`   Error stack: ${error.stack?.split("\n")[0] || "N/A"}`);
      return false;
    }
  }

  /**
   * Validate if the file is actually an image by checking its content with Sharp or heic-convert
   */
  private async validateImageContent(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    const extension = key.split(".").pop()?.toLowerCase();
    const isHeicFormat = this.isHeicFormat(key);
    const isRawFormat =
      extension &&
      [
        "cr2",
        "cr3",
        "nef",
        "arw",
        "dng",
        "orf",
        "rw2",
        "pef",
        "srw",
        "raf",
        "3fr",
        "fff",
        "dcr",
        "kdc",
        "srf",
        "x3f",
        "mef",
        "mos",
        "mrw",
        "nrw",
        "rw1",
        "rwl",
        "iiq",
        "k25",
        "crw",
        "erf",
        "sr2",
        "rwz",
        "bay",
        "cap",
        "eip",
        "dcs",
        "ptx",
        "pcd",
        "fpx",
        "raw",
      ].includes(extension);

    // Use heic-convert for HEIC/HEIF validation
    if (isHeicFormat) {
      return this.validateHeicContent(bucket, key);
    }

    try {
      // Get object as buffer for Sharp validation
      const inputBuffer = await this.getObjectAsBuffer(bucket, key);

      // Use Sharp to validate the image format
      const metadata = await sharp(inputBuffer).metadata();

      if (metadata.format !== undefined) {
        console.log(`✅ Validated as ${metadata.format} format`);
        return true;
      } else {
        console.warn(`⚠️  Could not determine format`);
        return false;
      }
    } catch (error) {
      // Check if it's a "file not found" error
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        console.error(`❌ File not found in S3`);
        throw new Error(`File not found in S3`);
      }

      if (isRawFormat) {
        console.warn(
          `⚠️  RAW format validation failed. This may indicate missing RAW codec support.`,
        );
        // For RAW formats, we're more permissive as they may not be fully supported
        return true;
      } else {
        console.warn(`❌ Failed to validate image content: ${error.message}`);
        // For standard formats, fall back to extension check
        return true;
      }
    }
  }

  /**
   * Get file size from S3 object metadata
   */
  private async getFileSize(bucket: string, key: string): Promise<number> {
    try {
      const headObject = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      return headObject.ContentLength || 0;
    } catch (error) {
      // Check if it's a "file not found" error
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        console.error(`❌ File not found in S3`);
        throw new Error(`File not found in S3`);
      }

      console.error(`❌ Error getting file size:`, {
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
        bucket: bucket,
      });
      throw new Error(`Failed to get file size: ${error.message}`);
    }
  }

  /**
   * Convert HEIC/HEIF image to WebP using heic-decode with Sharp fallback
   */
  private async convertHeicToWebp(
    bucket: string,
    key: string,
  ): Promise<string> {
    const webpKey = key.replace(/\.(heic|heif)$/i, ".webp");
    const startTime = Date.now();

    try {
      console.log(`🔄 Converting HEIC/HEIF to WebP format using libheif-js...`);

      // Get the HEIC/HEIF file from S3
      const inputBuffer = await this.getObjectAsBuffer(bucket, key);

      if (!inputBuffer || inputBuffer.length === 0) {
        throw new Error(`Empty or invalid HEIC/HEIF file: ${key}`);
      }

      const inputSizeMB = inputBuffer.length / (1024 * 1024);
      console.log(`📏 Input HEIC/HEIF size: ${inputSizeMB.toFixed(2)} MB`);

      let outputBuffer: Buffer;

      try {
        // Try heic-decode first
        console.log(`⚙️  Starting HEIC/HEIF conversion with heic-decode...`);

        // Decode the HEIC/HEIF image
        const { width, height, data } = await decode({ buffer: inputBuffer });

        if (!data || data.length === 0 || width <= 0 || height <= 0) {
          throw new Error(`No valid image data found in HEIC/HEIF file`);
        }

        // Production optimized Sharp processing
        outputBuffer = await sharp(Buffer.from(data), {
          raw: {
            width: width,
            height: height,
            channels: 4,
          },
          limitInputPixels: this.maxPixels,
          sequentialRead: true,
        })
          .resize({
            width: 1920,
            height: 1920,
            fit: "inside",
            withoutEnlargement: true,
            kernel: sharp.kernel.lanczos3,
          })
          .webp({
            quality: 70, // Matches JPEG 70 visual quality with 30% smaller file size
            effort: 6, // Maximum compression effort (automatic progressive loading)
            smartSubsample: true, // Better quality preservation
            force: true,
          })
          .toBuffer();
      } catch (heicDecodeError) {
        console.warn(`⚠️  heic-decode failed: ${heicDecodeError.message}`);
        console.log(`🔄 Falling back to Sharp for HEIC conversion...`);

        try {
          // Production Sharp fallback
          outputBuffer = await sharp(inputBuffer, {
            limitInputPixels: this.maxPixels,
            sequentialRead: true,
            failOnError: false,
          })
            .resize({
              width: 1920,
              height: 1920,
              fit: "inside",
              withoutEnlargement: true,
              kernel: sharp.kernel.lanczos3,
            })
            .webp({
              quality: 70,
              effort: 6,
              smartSubsample: true,
              force: true,
            })
            .toBuffer();
        } catch (sharpError) {
          console.error(`❌ Both heic-decode and Sharp failed`);
          console.error(`   heic-decode error: ${heicDecodeError.message}`);
          console.error(`   Sharp error: ${sharpError.message}`);
          throw new Error(
            `Both HEIC conversion methods failed: heic-decode (${heicDecodeError.message}) and Sharp (${sharpError.message})`,
          );
        }
      }

      const outputSizeMB = outputBuffer.length / (1024 * 1024);
      const compressionRatio = (
        ((inputSizeMB - outputSizeMB) / inputSizeMB) *
        100
      ).toFixed(1);
      const sizeReduction = (inputSizeMB - outputSizeMB).toFixed(2);

      console.log(`📏 Output WebP size: ${outputSizeMB.toFixed(2)} MB`);
      console.log(
        `📊 Size reduction: ${sizeReduction}MB (${compressionRatio}% smaller)`,
      );

      // Upload the converted WebP to S3
      console.log(`📤 Uploading converted WebP to S3...`);
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: webpKey,
          Body: outputBuffer,
          ContentType: "image/webp",
          StorageClass: "STANDARD",
        }),
      );

      const conversionTime = Date.now() - startTime;
      console.log(`✅ Converted HEIC/HEIF to WebP in ${conversionTime}ms`);
      console.log(
        `   Final result: ${inputSizeMB.toFixed(2)}MB → ${outputSizeMB.toFixed(2)}MB (${compressionRatio}% reduction)`,
      );

      return webpKey;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      console.error(
        `❌ Failed to convert HEIC/HEIF to WebP after ${conversionTime}ms:`,
        error.message,
      );
      console.error(`   Error code: ${error.code || "unknown"}`);
      console.error(
        `   Error details: ${error.stack?.split("\n")[0] || "N/A"}`,
      );

      // Check if it's a file not found error
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        throw new Error(`HEIC/HEIF file not found in S3: ${bucket}/${key}`);
      }

      // Check if it's a corruption error that indicates we should skip this file
      const errorMessage = error.message || "";
      if (
        errorMessage.includes("bad seek") ||
        errorMessage.includes("Unexpected end of file") ||
        errorMessage.includes("Extent in iloc box") ||
        errorMessage.includes("Invalid input") ||
        errorMessage.includes("compression format has not been built in") ||
        errorMessage.includes("Both HEIC conversion methods failed")
      ) {
        console.warn(
          `⚠️  HEIC/HEIF file appears corrupted or unsupported, marking as skipped`,
        );
        // Return a special error that indicates this should be skipped, not failed
        throw new Error(`HEIC_CORRUPTED: ${errorMessage}`);
      }

      throw new Error(`HEIC/HEIF conversion failed: ${error.message}`);
    }
  }

  /**
   * Check if the file is a RAW camera format
   */
  private isRawFormat(key: string): boolean {
    const extension = key.split(".").pop()?.toLowerCase();
    const rawFormats = [
      "raw",
      "cr2",
      "cr3",
      "nef",
      "arw",
      "dng",
      "orf",
      "rw2",
      "pef",
      "srw",
      "raf",
      "3fr",
      "fff",
      "dcr",
      "kdc",
      "srf",
      "x3f",
      "mef",
      "mos",
      "mrw",
      "nrw",
      "rw1",
      "rwl",
      "iiq",
      "k25",
      "crw",
      "erf",
      "sr2",
      "rwz",
      "bay",
      "cap",
      "eip",
      "dcs",
      "ptx",
      "pcd",
      "fpx",
    ];
    return extension ? rawFormats.includes(extension) : false;
  }

  /**
   * Convert image to JPEG format if it's not already JPEG
   */

  async process(job: Job): Promise<any> {
    const jobName = job.name;
    const jobId = job.id?.toString() || "unknown";

    // Track active jobs for monitoring
    this.activeJobs.add(jobId);

    try {
      if (jobName === "generate-preview") {
        return await this.processGeneratePreview(job);
      } else if (jobName === "test-heic-conversion") {
        return await this.testHeicConversion(job.data.bucket, job.data.key);
      } else {
        throw new Error(`Unknown job type: ${jobName}`);
      }
    } finally {
      this.activeJobs.delete(jobId);
      // Force garbage collection if available
      if (global.gc && this.activeJobs.size === 0) {
        global.gc();
      }
    }
  }

  async processGeneratePreview(
    job: Job<{ bucket: string; key: string }>,
  ): Promise<any> {
    const { bucket, key } = job.data;
    const startTime = Date.now();
    const startMemory = process.memoryUsage();

    try {
      // Step 1: Check if file exists in S3
      const exists = await this.fileExists(bucket, key);
      if (!exists) {
        console.error(`❌ Skipping - File does not exist in S3`);
        this.skippedCount++;
        console.log(
          `📊 Current Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        throw new Error(`File not found in S3`);
      }

      // Step 2: Check if file is an image by content type
      const isImage = await this.isImageFile(bucket, key);
      if (!isImage) {
        console.log(`⏭️  Skipping - Not an image file (content type check)`);
        this.skippedCount++;
        console.log(
          `📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        return {
          skipped: true,
          reason: "Not an image file (content type)",
          fileType: key.split(".").pop()?.toLowerCase() || "unknown",
        };
      }

      // Step 3: Validate actual image content
      const isValidImage = await this.validateImageContent(bucket, key);
      if (!isValidImage) {
        console.log(`⏭️  Skipping - Not a valid image file (content check)`);
        this.skippedCount++;
        console.log(
          `📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        return {
          skipped: true,
          reason: "Not a valid image file (content)",
          fileType: key.split(".").pop()?.toLowerCase() || "unknown",
        };
      }

      // Step 4: Determine output format and preview key
      const fileExtension = key.split(".").pop()?.toLowerCase();
      const isPng = fileExtension === "png";
      const isWebp = fileExtension === "webp";
      const isJpeg = fileExtension === "jpg" || fileExtension === "jpeg";
      const isHeic = this.isHeicFormat(key);
      const isRaw = this.isRawFormat(key);

      // Skip RAW files - they are not supported for processing
      if (isRaw) {
        console.log(
          `⏭️  Skipping - RAW format files are not supported for preview generation`,
        );
        this.skippedCount++;
        console.log(
          `📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        return {
          skipped: true,
          reason: "RAW format not supported",
          fileType: fileExtension || "unknown",
        };
      }

      // Determine preview key - keep extension for PNG/WebP, change to .jpg for others
      let previewKey: string;
      let processKey = key;

      if (key.startsWith("Orginal") || key.startsWith("Original")) {
        if (isPng || isWebp) {
          previewKey = key.replace(/^(Orginal|Original)/, "Preview");
        } else {
          previewKey = key
            .replace(/^(Orginal|Original)/, "Preview")
            .replace(/\.[^/.]+$/, ".jpg");
        }
      } else {
        if (isPng || isWebp) {
          previewKey = `Preview/${key}`;
        } else {
          const jpegKey = key.replace(/\.[^/.]+$/, ".jpg");
          previewKey = `Preview/${jpegKey}`;
        }
      }

      // For HEIC files, we need to convert first (using heic-decode library)
      if (isHeic) {
        try {
          console.log(`🔄 Converting HEIC file to WebP...`);
          processKey = await this.convertHeicToWebp(bucket, key);
          console.log(`✅ HEIC converted successfully`);
        } catch (conversionError) {
          if (conversionError.message?.startsWith("HEIC_CORRUPTED:")) {
            console.log(`⏭️  Skipping corrupted HEIC/HEIF file`);
            this.skippedCount++;
            console.log(
              `📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
            );
            return {
              skipped: true,
              reason: "Corrupted or unsupported HEIC/HEIF file",
              fileType: fileExtension || "unknown",
              error: conversionError.message.replace("HEIC_CORRUPTED: ", ""),
            };
          }
          throw conversionError;
        }
      }

      console.log(
        `📸 Processing image (Start: ${Math.round(startMemory.heapUsed / 1024 / 1024)}MB)`,
      );

      // Production Sharp transform with aggressive optimization
      let sharpTransform = sharp({
        failOnError: false,
        density: 72,
        limitInputPixels: this.maxPixels,
        sequentialRead: true,
        pages: 1, // Only process first page/frame
      }).resize({
        width: 1920,
        height: 1920,
        fit: "inside",
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3,
        fastShrinkOnLoad: true,
      });

      // Apply format-specific compression
      let contentType: string;
      let outputFormat: string;

      if (isPng) {
        console.log(`📦 Compressing PNG`);
        sharpTransform = sharpTransform.png({
          quality: 80,
          compressionLevel: 9, // Maximum compression
          adaptiveFiltering: true,
          force: true,
        });
        contentType = "image/png";
        outputFormat = "png";
      } else {
        // Convert all formats to WebP for optimal compression and progressive loading
        if (isWebp) {
          console.log(`📦 Compressing WebP`);
        } else if (!isJpeg && !isHeic) {
          console.log(`🔄 Converting to WebP...`);
        } else {
          console.log(`🔄 Converting to WebP`);
        }
        sharpTransform = sharpTransform.webp({
          quality: 70, // Matches JPEG 70 visual quality with 30% smaller file size
          effort: 6, // Maximum compression effort (automatic progressive loading)
          smartSubsample: true, // Better quality preservation
          force: true,
        });
        contentType = "image/webp";
        outputFormat = "webp";
        // Update preview key to .webp extension for non-webp files
        if (!isWebp && !isPng) {
          previewKey = previewKey.replace(/\.(jpg|jpeg)$/i, ".webp");
        }
      }

      // Log upload parameters for debugging
      this.logger.log(`📤 Starting main preview upload`);

      // Create PassThrough stream for proper pipeline
      const passThrough = new PassThrough();

      const uploadPromise = this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: previewKey,
          Body: passThrough,
          ContentType: contentType,
          StorageClass: "STANDARD",
        }),
      );

      // Note: AWS S3 upload stream only emits 'httpUploadProgress' events, errors are handled in promise

      // Proper stream pipeline: download → sharp → passThrough → upload
      const downloadStream = await this.getObjectStream(bucket, processKey);

      // Add stream debugging and error handling
      downloadStream.on("error", (error) => {
        this.logger.error(`❌ Download stream error: ${error.message}`);
      });

      sharpTransform.on("error", (error) => {
        this.logger.error(`❌ Sharp transform error: ${error.message}`);
      });

      passThrough.on("error", (error) => {
        this.logger.error(`❌ PassThrough stream error: ${error.message}`);
      });

      // Chain the streams correctly
      downloadStream.pipe(sharpTransform).pipe(passThrough);

      await uploadPromise;

      // Log upload result details for debugging
      this.logger.log(`📤 Upload successful`);

      // Verify the file was actually uploaded by checking if it exists
      try {
        await this.s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: previewKey }),
        );
        this.logger.log(`✅ Verified: File exists in S3`);
      } catch (verifyError) {
        this.logger.error(
          `❌ Upload verification failed: ${verifyError.message}`,
        );
        throw new Error(`Upload verification failed: ${verifyError.message}`);
      }

      const endTime = Date.now();
      const endMemory = process.memoryUsage();
      const processingTime = endTime - startTime;
      const memoryDelta = Math.round(
        (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024,
      );

      this.logger.log(
        `✅ Completed in ${processingTime}ms (Memory: +${memoryDelta}MB)`,
      );

      return { previewKey: previewKey };
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
    await new Promise((resolve) => setTimeout(resolve, 1000));

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
