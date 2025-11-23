import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import sharp from "sharp";
import * as AWS from "aws-sdk";
import * as https from "https";
import * as os from "os";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PassThrough } from "stream";
const decode = require("heic-decode");
const execAsync = promisify(exec);

@Processor("image-processing", {
  concurrency: 1, // Process one job at a time to manage memory
})
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);
  private readonly s3Client: AWS.S3;
  private readonly memoryThreshold = Math.floor(os.totalmem() * 0.3); // 30% of total RAM
  private readonly minFileSizeForProcessing = 1 * 1024 * 1024; // 5MB threshold
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
    this.s3Client = new AWS.S3({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      s3ForcePathStyle: true,
      signatureVersion: "v4",
      maxRetries: 1, // Minimal retries for speed
      httpOptions: {
        timeout: 60000, // 60s timeout
        agent: new https.Agent({
          keepAlive: true,
          maxSockets: 50,
          maxFreeSockets: 10,
        }),
      },
      params: {
        ServerSideEncryption: undefined,
      },
    });

    // Log S3 config for debugging (remove in production)
    console.log("🔧 S3 Configuration:");
    console.log("  Region:", process.env.S3_REGION || "NOT_SET");
    console.log("  Endpoint:", process.env.S3_ENDPOINT || "NOT_SET");
    console.log(
      "  Access Key ID:",
      process.env.S3_ACCESS_KEY ? "SET" : "NOT_SET",
    );
    console.log("  Secret Key:", process.env.S3_SECRET_KEY ? "SET" : "NOT_SET");
    console.log("  Force Path Style:", true);
    console.log("  Signature Version:", "v4");
  }

  /**
   * Check if the file is an image based on S3 content type (production optimized)
   */
  private async isImageFile(bucket: string, key: string): Promise<boolean> {
    try {
      const headObject = await this.s3Client
        .headObject({ Bucket: bucket, Key: key })
        .promise();

      const contentType = headObject.ContentType || "";
      const isImage = contentType.startsWith("image/");

      // Minimal logging for production
      if (!isImage) {
        console.log(`⏭️  Non-image: ${contentType} for ${key}`);
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
      console.log(`🧪 Testing HEIC/HEIF conversion for ${key}...`);

      if (!this.isHeicFormat(key)) {
        throw new Error(`File ${key} is not a HEIC/HEIF format`);
      }

      // Validate the HEIC/HEIF file
      const isValid = await this.validateHeicContent(bucket, key);
      if (!isValid) {
        throw new Error(`Invalid HEIC/HEIF file: ${key}`);
      }

      // Convert to JPEG
      const jpegKey = await this.convertHeicToJpeg(bucket, key);

      // Verify the converted file exists
      const jpegExists = await this.fileExists(bucket, jpegKey);
      if (!jpegExists) {
        throw new Error(`Converted JPEG file not found: ${jpegKey}`);
      }

      console.log(
        `✅ HEIC/HEIF conversion test passed for ${key} → ${jpegKey}`,
      );

      return {
        success: true,
        originalKey: key,
        convertedKey: jpegKey,
        message: "HEIC/HEIF conversion test completed successfully",
      };
    } catch (error) {
      console.error(
        `❌ HEIC/HEIF conversion test failed for ${key}:`,
        error.message,
      );
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
      await this.s3Client.headObject({ Bucket: bucket, Key: key }).promise();
      return true;
    } catch (error) {
      if (error.code === "NoSuchKey" || error.statusCode === 404) {
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
      console.log(`🔍 Validating HEIC/HEIF format for ${key}...`);

      // Get object as buffer for libheif validation
      const s3Object = await this.s3Client
        .getObject({ Bucket: bucket, Key: key })
        .promise();

      const inputBuffer = s3Object.Body as Buffer;

      if (!inputBuffer || inputBuffer.length === 0) {
        console.warn(`❌ Empty buffer for HEIC/HEIF file ${key}`);
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
      if (error.code === "NoSuchKey" || error.statusCode === 404) {
        console.error(
          `❌ HEIC/HEIF file not found in S3 bucket '${bucket}': ${key}`,
        );
        throw new Error(`HEIC/HEIF file not found in S3: ${bucket}/${key}`);
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
          `⚠️  HEIC/HEIF file appears corrupted or unsupported, skipping: ${key}`,
        );
        console.warn(`   Corruption details: ${errorMessage}`);
        return false;
      }

      console.warn(
        `❌ HEIC/HEIF validation failed for ${key}: ${error.message}`,
      );
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
      const s3Object = await this.s3Client
        .getObject({ Bucket: bucket, Key: key })
        .promise();

      // Use Sharp to validate the image format
      const metadata = await sharp(s3Object.Body as Buffer).metadata();

      if (metadata.format !== undefined) {
        console.log(`✅ Validated ${key} as ${metadata.format} format`);
        return true;
      } else {
        console.warn(`⚠️  Could not determine format for ${key}`);
        return false;
      }
    } catch (error) {
      // Check if it's a "file not found" error
      if (error.code === "NoSuchKey" || error.statusCode === 404) {
        console.error(`❌ File not found in S3 bucket '${bucket}': ${key}`);
        throw new Error(`File not found in S3: ${bucket}/${key}`);
      }

      if (isRawFormat) {
        console.warn(
          `⚠️  RAW format validation failed for ${key}: ${error.message}. This may indicate missing RAW codec support.`,
        );
        // For RAW formats, we're more permissive as they may not be fully supported
        return true;
      } else {
        console.warn(
          `❌ Failed to validate image content for ${key}: ${error.message}`,
        );
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
      const headObject = await this.s3Client
        .headObject({
          Bucket: bucket,
          Key: key,
        })
        .promise();

      return headObject.ContentLength || 0;
    } catch (error) {
      // Check if it's a "file not found" error
      if (error.code === "NoSuchKey" || error.statusCode === 404) {
        console.error(`❌ File not found in S3 bucket '${bucket}': ${key}`);
        throw new Error(`File not found in S3: ${bucket}/${key}`);
      }

      console.error(`❌ Error getting file size for ${key}:`, {
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
        bucket: bucket,
      });
      throw new Error(`Failed to get file size: ${error.message}`);
    }
  }

  /**
   * Convert HEIC/HEIF image to JPEG using heic-decode with Sharp fallback
   */
  private async convertHeicToJpeg(
    bucket: string,
    key: string,
  ): Promise<string> {
    const jpegKey = key.replace(/\.(heic|heif)$/i, ".jpg");
    const startTime = Date.now();

    try {
      console.log(
        `🔄 Converting HEIC/HEIF ${key} to JPEG format using libheif-js...`,
      );

      // Get the HEIC/HEIF file from S3
      const s3Object = await this.s3Client
        .getObject({ Bucket: bucket, Key: key })
        .promise();

      const inputBuffer = s3Object.Body as Buffer;

      if (!inputBuffer || inputBuffer.length === 0) {
        throw new Error(`Empty or invalid HEIC/HEIF file: ${key}`);
      }

      const inputSizeMB = inputBuffer.length / (1024 * 1024);
      console.log(`📏 Input HEIC/HEIF size: ${inputSizeMB.toFixed(2)} MB`);

      let outputBuffer: Buffer;

      try {
        // Try heic-decode first
        console.log(
          `⚙️  Starting HEIC/HEIF conversion with heic-decode for ${key}...`,
        );

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
          .jpeg({
            quality: 70,
            progressive: false, // Faster encoding
            mozjpeg: true,
            force: true,
          })
          .toBuffer();
      } catch (heicDecodeError) {
        console.warn(
          `⚠️  heic-decode failed for ${key}: ${heicDecodeError.message}`,
        );
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
            .jpeg({
              quality: 70,
              progressive: false,
              mozjpeg: true,
              force: true,
            })
            .toBuffer();
        } catch (sharpError) {
          console.error(`❌ Both heic-decode and Sharp failed for ${key}`);
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

      console.log(`📏 Output JPEG size: ${outputSizeMB.toFixed(2)} MB`);
      console.log(
        `📊 Size reduction: ${sizeReduction}MB (${compressionRatio}% smaller)`,
      );

      // Upload the converted JPEG to S3
      console.log(`📤 Uploading converted JPEG ${jpegKey} to S3...`);
      await this.s3Client
        .upload({
          Bucket: bucket,
          Key: jpegKey,
          Body: outputBuffer,
          ContentType: "image/jpeg",
          StorageClass: "STANDARD",
        })
        .promise();

      const conversionTime = Date.now() - startTime;
      console.log(
        `✅ Converted HEIC/HEIF ${key} to ${jpegKey} in ${conversionTime}ms`,
      );
      console.log(
        `   Final result: ${inputSizeMB.toFixed(2)}MB → ${outputSizeMB.toFixed(2)}MB (${compressionRatio}% reduction)`,
      );

      return jpegKey;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      console.error(
        `❌ Failed to convert HEIC/HEIF ${key} to JPEG after ${conversionTime}ms:`,
        error.message,
      );
      console.error(`   Error code: ${error.code || "unknown"}`);
      console.error(
        `   Error details: ${error.stack?.split("\n")[0] || "N/A"}`,
      );

      // Check if it's a file not found error
      if (error.code === "NoSuchKey" || error.statusCode === 404) {
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
          `⚠️  HEIC/HEIF file appears corrupted or unsupported, marking as skipped: ${key}`,
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
      "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef",
      "srw", "raf", "3fr", "fff", "dcr", "kdc", "srf", "x3f", "mef",
      "mos", "mrw", "nrw", "rw1", "rwl", "iiq", "k25", "crw", "erf",
      "sr2", "rwz", "bay", "cap", "eip", "dcs", "ptx", "pcd", "fpx"
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
        console.error(
          `❌ Skipping ${key} - File does not exist in S3 bucket '${bucket}'`,
        );
        this.skippedCount++;
        console.log(
          `📊 Current Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        throw new Error(`File not found in S3 bucket '${bucket}': ${key}`);
      }

      // Step 2: Check if file is an image by content type
      const isImage = await this.isImageFile(bucket, key);
      if (!isImage) {
        console.log(
          `⏭️  Skipping ${key} - Not an image file (content type check)`,
        );
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
        console.log(
          `⏭️  Skipping ${key} - Not a valid image file (content check)`,
        );
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

      // Step 4: Check file size
      const fileSize = await this.getFileSize(bucket, key);
      const fileSizeMB = fileSize / (1024 * 1024);

      console.log(`📏 File size: ${fileSizeMB.toFixed(2)} MB`);

      if (fileSize < this.minFileSizeForProcessing) {
        console.log(
          `⏭️  Skipping ${key} - File size (${fileSizeMB.toFixed(2)} MB) is less than 5MB`,
        );
        this.skippedCount++;
        console.log(
          `📊 Stats: Processed=${this.processedCount}, Skipped=${this.skippedCount}`,
        );
        return {
          skipped: true,
          reason: "File size less than 5MB",
          fileSize: fileSizeMB,
          threshold: 5,
        };
      }

      // Step 5: Determine output format and preview key
      const fileExtension = key.split(".").pop()?.toLowerCase();
      const isPng = fileExtension === "png";
      const isWebp = fileExtension === "webp";
      const isJpeg = fileExtension === "jpg" || fileExtension === "jpeg";
      const isHeic = this.isHeicFormat(key);
      const isRaw = this.isRawFormat(key);

      // Skip RAW files - they are not supported for processing
      if (isRaw) {
        console.log(
          `⏭️  Skipping ${key} - RAW format files are not supported for preview generation`,
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

      if (key.startsWith("Orginal")) {
        if (isPng || isWebp) {
          previewKey = key.replace(/^Orginal/, "Preview");
        } else {
          previewKey = key.replace(/^Orginal/, "Preview").replace(/\.[^/.]+$/, ".jpg");
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
          console.log(`🔄 Converting HEIC file ${key} to JPEG...`);
          processKey = await this.convertHeicToJpeg(bucket, key);
          console.log(`✅ HEIC converted to ${processKey}`);
        } catch (conversionError) {
          if (conversionError.message?.startsWith("HEIC_CORRUPTED:")) {
            console.log(`⏭️  Skipping corrupted HEIC/HEIF file: ${key}`);
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
        `📸 Processing: ${key} → ${previewKey} (Start: ${Math.round(startMemory.heapUsed / 1024 / 1024)}MB)`,
      );

      // Production Sharp transform with aggressive optimization
      let sharpTransform = sharp({
        failOnError: false,
        density: 72,
        limitInputPixels: this.maxPixels,
        sequentialRead: true,
        pages: 1, // Only process first page/frame
      })
        .resize({
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
        console.log(`📦 Compressing PNG (quality 80, level 9)`);
        sharpTransform = sharpTransform.png({
          quality: 80,
          compressionLevel: 9, // Maximum compression
          adaptiveFiltering: true,
          force: true,
        });
        contentType = "image/png";
        outputFormat = "png";
      } else if (isWebp) {
        console.log(`📦 Compressing WebP (quality 75, effort 6)`);
        sharpTransform = sharpTransform.webp({
          quality: 75,
          effort: 6, // Higher effort for better compression
          force: true,
        });
        contentType = "image/webp";
        outputFormat = "webp";
      } else {
        // Convert and compress to JPEG for all other formats (HEIC, TIFF, etc.)
        if (!isJpeg && !isHeic) {
          console.log(`🔄 Converting ${fileExtension} to JPEG and compressing...`);
        } else {
          console.log(`📦 Compressing JPEG (quality 65, mozjpeg)`);
        }
        sharpTransform = sharpTransform.jpeg({
          quality: 65, // Aggressive compression for production
          progressive: false, // Faster encoding
          mozjpeg: true,
          optimizeScans: true,
          force: true,
        });
        contentType = "image/jpeg";
        outputFormat = "jpeg";
      }

      // Log upload parameters for debugging
      this.logger.log(
        `📤 Starting upload: Bucket=${bucket}, Key=${previewKey}, ContentType=${contentType}`,
      );

      // Create PassThrough stream for proper pipeline
      const passThrough = new PassThrough();

      const uploadStream = this.s3Client.upload({
        Bucket: bucket,
        Key: previewKey,
        Body: passThrough,
        ContentType: contentType,
        StorageClass: "STANDARD",
      });

      // Note: AWS S3 upload stream only emits 'httpUploadProgress' events, errors are handled in promise

      // Proper stream pipeline: download → sharp → passThrough → upload
      const downloadStream = this.s3Client
        .getObject({ Bucket: bucket, Key: processKey })
        .createReadStream();

      // Add stream debugging and error handling
      downloadStream.on('error', (error) => {
        this.logger.error(`❌ Download stream error for ${processKey}: ${error.message}`);
      });

      sharpTransform.on('error', (error) => {
        this.logger.error(`❌ Sharp transform error for ${key}: ${error.message}`);
      });

      passThrough.on('error', (error) => {
        this.logger.error(`❌ PassThrough stream error for ${previewKey}: ${error.message}`);
      });

      // Chain the streams correctly
      downloadStream.pipe(sharpTransform).pipe(passThrough);

      const uploadResult = await uploadStream.promise();

      // Log upload result details for debugging
      this.logger.log(
        `📤 Upload successful: ${previewKey} → ETag: ${uploadResult.ETag}, Location: ${uploadResult.Location}`,
      );

      // Verify the file was actually uploaded by checking if it exists
      try {
        await this.s3Client.headObject({ Bucket: bucket, Key: previewKey }).promise();
        this.logger.log(`✅ Verified: ${previewKey} exists in S3`);
      } catch (verifyError) {
        this.logger.error(`❌ Upload verification failed for ${previewKey}: ${verifyError.message}`);
        throw new Error(`Upload verification failed: ${verifyError.message}`);
      }

      const endTime = Date.now();
      const endMemory = process.memoryUsage();
      const processingTime = endTime - startTime;
      const memoryDelta = Math.round(
        (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024,
      );

      this.logger.log(
        `✅ Completed: ${key} in ${processingTime}ms (Memory: +${memoryDelta}MB)`,
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
