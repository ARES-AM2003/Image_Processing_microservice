import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger, OnModuleInit } from "@nestjs/common";
import sharp from "sharp";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
import { Readable } from "stream";
const decode = require("heic-decode");
const execAsync = promisify(exec);

// Calculate worker concurrency based on CPU cores.
// We use half the CPU count so each job still gets dedicated threads via Sharp.
// Minimum 2 for meaningful parallelism, capped at 8 to prevent memory spikes.
const WORKER_CONCURRENCY = Math.min(
  8,
  Math.max(2, Math.floor(os.cpus().length / 2)),
);

// Each concurrent job gets an equal share of Sharp's thread pool.
// At minimum 1, capped at 4 threads per job (plenty for most images).
const SHARP_THREADS_PER_JOB = Math.min(
  4,
  Math.max(1, Math.floor(os.cpus().length / WORKER_CONCURRENCY)),
);

const WORKER_RETURN_SCHEMA = "preview-worker-v2";

@Processor("image-processing", {
  concurrency: WORKER_CONCURRENCY, // Process multiple jobs in parallel, utilizing idle I/O time
  lockDuration: 300000, // 5 minutes lock duration for long-running jobs
  lockRenewTime: 15000, // Renew lock every 15 seconds
})
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);
  private readonly s3Client: S3Client;
  // With parallel workers, each job can use more memory simultaneously.
  // We allow up to 70% total RAM across all jobs (30% / concurrency each).
  private readonly memoryThreshold = Math.floor(
    (os.totalmem() * 0.7) / WORKER_CONCURRENCY,
  );

  private readonly maxPixels = 50 * 1024 * 1024; // 50MP limit for safety
  private processedCount = 0;
  private skippedCount = 0;
  private totalProcessingTime = 0;
  private activeJobs = new Set<string>();

  private withWorkerSchema<T extends Record<string, any>>(result: T): T {
    return {
      ...result,
      workerSchema: WORKER_RETURN_SCHEMA,
    };
  }

  private maskSecret(value: string | undefined): string {
    if (!value) {
      return "<missing>";
    }

    if (value.length <= 6) {
      return "***";
    }

    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }

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
    // Divide Sharp's thread pool equally across concurrent BullMQ workers
    // so multiple jobs running in parallel don't starve each other's threads.
    sharp.concurrency(SHARP_THREADS_PER_JOB);
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
      maxAttempts: 10,
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

    this.logger.warn(
      `S3 env debug: region=${process.env.S3_REGION || "<missing>"}, endpoint=${process.env.S3_ENDPOINT || "<missing>"}, bucket=${process.env.S3_BUCKET_NAME || "<missing>"}, accessKeyId=${this.maskSecret(process.env.S3_ACCESS_KEY)}, secretAccessKey=${this.maskSecret(process.env.S3_SECRET_KEY)}`,
    );

    // S3 Configuration loaded
  }

  async onModuleInit(): Promise<void> {
    const bucket = process.env.S3_BUCKET_NAME?.trim();

    if (!bucket) {
      this.logger.warn("S3 startup probe skipped because S3_BUCKET_NAME is missing");
      return;
    }

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      this.logger.log(`✅ S3 startup probe succeeded for bucket ${bucket}`);
    } catch (error) {
      try {
        await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            MaxKeys: 1,
          }),
        );

        this.logger.log(
          `✅ S3 startup probe succeeded for bucket ${bucket} via ListObjectsV2 fallback`,
        );
        return;
      } catch (fallbackError) {
        const primary = this.describeS3Error(error);
        const fallback = this.describeS3Error(fallbackError);
        this.logger.error(
          `❌ S3 startup probe failed for bucket ${bucket}: HeadBucket=${primary}; ListObjectsV2=${fallback}`,
        );
      }
    }
  }

  private describeS3Error(error: unknown): string {
    const awsError = error as {
      name?: string;
      message?: string;
      Code?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number; requestId?: string };
    };

    const parts = [
      awsError?.name,
      awsError?.Code || awsError?.code,
      awsError?.$metadata?.httpStatusCode ? `HTTP ${awsError.$metadata.httpStatusCode}` : undefined,
      awsError?.$metadata?.requestId ? `requestId=${awsError.$metadata.requestId}` : undefined,
      awsError?.message,
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(" | ") : String(error);
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
      
      // If ContentType is set and is an image, return true
      if (contentType && contentType.startsWith("image/")) {
        console.log(`✅ Image file detected by content type: ${contentType}`);
        return true;
      }

      // ContentType not set or not an image - fall back to extension check
      console.log(`⏭️  ContentType missing or not image (${contentType || "empty"}), checking extension...`);
      const extension = key.split(".").pop()?.toLowerCase();
      const isSupported = extension ? this.supportedImageFormats.includes(extension) : false;
      
      if (!isSupported) {
        console.log(`⏭️  Non-image file detected (extension: ${extension || "unknown"})`);
      }
      
      return isSupported;
    } catch (error) {
      // Check if it's a 404 - file doesn't exist
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        console.error(`❌ File not found in S3: ${bucket}/${key}`);
        throw new Error(`File not found in S3`);
      }

      // For other errors (permission issues, network issues, etc.), fall back to extension check
      console.warn(`⚠️  HeadObject failed for ${key}: ${(error as any).message}. Falling back to extension check.`);
      const extension = key.split(".").pop()?.toLowerCase();
      const isSupported = extension ? this.supportedImageFormats.includes(extension) : false;
      
      if (!isSupported) {
        console.log(`⏭️  File extension not supported: ${extension || "unknown"}`);
      }
      
      return isSupported;
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
      console.error(`❌ HEIC/HEIF conversion test failed:`, (error as any).message);
      return {
        success: false,
        originalKey: key,
        error: (error as any).message,
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

      const message = awsError?.message || "Unknown S3 error";
      throw new Error(`S3 existence check failed for ${bucket}/${key}: ${message}`);
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
      const errorMessage = (error as any).message || "";
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

      console.warn(`❌ HEIC/HEIF validation failed: ${(error as any).message}`);
      console.warn(`   Error code: ${(error as any).code || "unknown"}`);
      console.warn(`   Error stack: ${(error as any).stack?.split("\n")[0] || "N/A"}`);
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
        console.warn(`❌ Failed to validate image content: ${(error as any).message}`);
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
        code: (error as any).code,
        statusCode: (error as any).statusCode,
        message: (error as any).message,
        bucket: bucket,
      });
      throw new Error(`Failed to get file size: ${(error as any).message}`);
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
        console.warn(`⚠️  heic-decode failed: ${(heicDecodeError as any).message}`);
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
          console.error(`   heic-decode error: ${(heicDecodeError as any).message}`);
          console.error(`   Sharp error: ${(sharpError as any).message}`);
          throw new Error(
            `Both HEIC conversion methods failed: heic-decode (${(heicDecodeError as any).message}) and Sharp (${(sharpError as any).message})`,
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
      let uploadAttempts = 0;
      const maxUploadAttempts = 5;
      while (uploadAttempts < maxUploadAttempts) {
        try {
          await this.s3Client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: webpKey,
              Body: outputBuffer,
              ContentType: "image/webp",
              StorageClass: "STANDARD",
            }),
          );
          break;
        } catch (uploadError: any) {
          uploadAttempts++;
          if (
            uploadAttempts >= maxUploadAttempts ||
            (!uploadError.message?.includes("temporary failure") &&
              !uploadError.message?.includes("ServiceUnavailable") &&
              uploadError.$metadata?.httpStatusCode !== 503)
          ) {
            throw uploadError;
          }
          console.warn(`⚠️ WebP upload failed (attempt ${uploadAttempts}/${maxUploadAttempts}): ${uploadError.message}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, uploadAttempts * 2000));
        }
      }

      const conversionTime = Date.now() - startTime;
      console.log(`✅ Converted HEIC/HEIF to WebP in ${conversionTime}ms`);
      console.log(
        `   Final result: ${inputSizeMB.toFixed(2)}MB → ${outputSizeMB.toFixed(2)}MB (${compressionRatio}% reduction)`,
      );

      return webpKey;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      console.error(
        `❌ Failed to convert HEIC/HEIF to WebP after ${conversionTime}ms: ${(error as any).message}`,
      );
      console.error(`   Error code: ${(error as any).code || "unknown"}`);
      console.error(`   Error details: ${(error as any).stack?.split("\n")[0] || "N/A"}}`);

      // Check if it's a file not found error
      const awsError = error as any;
      if (awsError?.name === "NotFound" || awsError?.$metadata?.httpStatusCode === 404) {
        throw new Error(`HEIC/HEIF file not found in S3: ${bucket}/${key}`);
      }

      // Check if it's a corruption error that indicates we should skip this file
      const errorMessage = (error as any).message || "";
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

      throw new Error(`HEIC/HEIF conversion failed: ${(error as any).message}`);
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
    }
  }

  async processGeneratePreview(
    job: Job<{ bucket: string; key: string }>,
  ): Promise<any> {
    const { bucket } = job.data;
    const key = job.data.key;
    const fileExtension = key.split(".").pop()?.toLowerCase() || "unknown";

    const startTime = Date.now();
    const startMemory = process.memoryUsage();

    try {
      // Step 1: Short-circuit if preview already exists in S3.
      // This is the most common skip path for re-submitted batches where a prior
      // run already generated the preview. One cheap HeadObject call avoids a full
      // download + re-encode + re-upload cycle, and surfaces a proper reason so the
      // service never logs "reason: unknown".
      const previewKeyEarly = key
        .replace(/\.[^/.]+$/, ".webp")
        .replace(/^(Orginal|Original)/, "Preview");

      const previewAlreadyExists = await this.fileExists(bucket, previewKeyEarly);
      if (previewAlreadyExists) {
        console.log(`⏭️  Skipping — preview already exists at ${previewKeyEarly}`);
        this.skippedCount++;
        return this.withWorkerSchema({
          skipped: true,
          reason: "Preview already exists",
          previewKey: previewKeyEarly, // include so service can still mark it ready if needed
          originalKey: key,
        });
      }

      // Step 2: Check if file is an image by content type / extension
      const isImage = await this.isImageFile(bucket, key);
      if (!isImage) {
        console.log(`⏭️  Skipping - Not an image file (content type check)`);
        this.skippedCount++;
        console.log(`📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`);
        return this.withWorkerSchema({
          skipped: true,
          reason: "Not an image file (content type)",
          fileType: fileExtension,
          originalKey: key,
        });
      }

      // Step 3: Skip RAW files BEFORE downloading — avoids pulling the entire file from S3
      if (this.isRawFormat(key)) {
        console.log(`⏭️  Skipping - RAW format files are not supported for preview generation`);
        this.skippedCount++;
        console.log(`📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`);
        return this.withWorkerSchema({
          skipped: true,
          reason: "RAW format not supported",
          fileType: fileExtension,
          originalKey: key,
        });
      }

      // Step 4: Validate actual image content (downloads the file — RAW already excluded above)
      const isValidImage = await this.validateImageContent(bucket, key);
      if (!isValidImage) {
        console.log(`⏭️  Skipping - Not a valid image file (content check)`);
        this.skippedCount++;
        console.log(`📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`);
        return this.withWorkerSchema({
          skipped: true,
          reason: "Not a valid image file (content)",
          fileType: fileExtension,
          originalKey: key,
        });
      }

      // Step 5: Determine output format and preview key
      const isWebp = fileExtension === "webp";
      const isHeic = this.isHeicFormat(key);

      // Everything becomes WebP for optimal web compression
      const previewKey = key
        .replace(/\.[^/.]+$/, ".webp")
        .replace(/^(Orginal|Original)/, "Preview");

      let processKey = key;

      // For HEIC files, convert to WebP first using heic-decode library
      if (isHeic) {
        try {
          console.log(`🔄 Converting HEIC file to WebP...`);
          processKey = await this.convertHeicToWebp(bucket, key);
          console.log(`✅ HEIC converted successfully`);
        } catch (conversionError) {
          if ((conversionError as any).message?.startsWith("HEIC_CORRUPTED:")) {
            console.log(`⏭️  Skipping corrupted HEIC/HEIF file`);
            this.skippedCount++;
            console.log(`📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`);
            return this.withWorkerSchema({
              skipped: true,
              reason: "Corrupted or unsupported HEIC/HEIF file",
              fileType: fileExtension,
              error: (conversionError as any).message.replace("HEIC_CORRUPTED: ", ""),
              originalKey: key,
            });
          }
          throw conversionError;
        }
      }

      console.log(`📸 Processing image (Start: ${Math.round(startMemory.heapUsed / 1024 / 1024)}MB)`);

      // Load source object — avoids unknown-length streaming upload issues
      const sourceBuffer = await this.getObjectAsBuffer(bucket, processKey);

      // Production Sharp transform with aggressive optimization
      let sharpTransform = sharp(sourceBuffer, {
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

      if (isWebp) {
        console.log(`📦 Compressing existing WebP`);
      } else {
        console.log(`🔄 Converting to WebP (${fileExtension} -> webp)`);
      }

      sharpTransform = sharpTransform.webp({
        quality: 70,      // Matches JPEG 70 visual quality with ~30% smaller file size
        effort: 6,        // Maximum compression effort
        smartSubsample: true, // Better chroma quality
        force: true,
      });

      this.logger.log(`📤 Starting main preview upload to ${previewKey}`);
      const outputBuffer = await sharpTransform.toBuffer();

      // Upload with automatic retry on transient S3 errors
      let uploadAttempts = 0;
      const maxUploadAttempts = 5;
      while (uploadAttempts < maxUploadAttempts) {
        try {
          await this.s3Client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: previewKey,
              Body: outputBuffer,
              ContentLength: outputBuffer.length,
              ContentType: "image/webp",
              StorageClass: "STANDARD",
            }),
          );
          break;
        } catch (uploadError: any) {
          uploadAttempts++;
          if (
            uploadAttempts >= maxUploadAttempts ||
            (!uploadError.message?.includes("temporary failure") &&
              !uploadError.message?.includes("ServiceUnavailable") &&
              uploadError.$metadata?.httpStatusCode !== 503)
          ) {
            throw uploadError;
          }
          this.logger.warn(
            `⚠️ Upload failed (attempt ${uploadAttempts}/${maxUploadAttempts}): ${uploadError.message}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, uploadAttempts * 2000));
        }
      }

      // Confirm the preview actually exists in S3 before marking it complete
      try {
        await this.s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: previewKey }),
        );
        this.logger.log(`✅ S3 verified: preview exists at ${previewKey}`);
      } catch (verifyError) {
        throw new Error(`Upload verification failed — file not found in S3 after upload: ${(verifyError as any).message}`);
      }

      const processingTime = Date.now() - startTime;
      const memoryDelta = Math.round(
        (process.memoryUsage().heapUsed - startMemory.heapUsed) / 1024 / 1024,
      );
      this.logger.log(`✅ Completed in ${processingTime}ms (Memory: +${memoryDelta}MB)`);

      // Return BOTH keys — service uses previewKey as the gate for status updates
      return this.withWorkerSchema({ previewKey, originalKey: key });
    } catch (error) {
      this.logger.error(`❌ Failed to process ${key}: ${(error as any).message}`);
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
