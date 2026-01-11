import { ApiProperty } from "@nestjs/swagger";

export class ProcessingResultDto {
  @ApiProperty({
    description: "Whether the file was processed or skipped",
    example: true,
  })
  processed?: boolean;

  @ApiProperty({
    description: "Whether the file was skipped during processing",
    example: false,
  })
  skipped?: boolean;

  @ApiProperty({
    description: "Reason for skipping the file",
    example: "File size less than 5MB",
    required: false,
  })
  reason?: string;

  @ApiProperty({
    description: "Original file key that was submitted for processing",
    example: "Orginal/photos/IMG_001.png",
  })
  originalKey?: string;

  @ApiProperty({
    description:
      "Key of the file that was actually processed (after WebP conversion if needed)",
    example: "Orginal/photos/IMG_001.webp",
    required: false,
  })
  processedKey?: string;

  @ApiProperty({
    description: "Key of the generated preview/processed image",
    example: "Preview/photos/IMG_001.webp",
    required: false,
  })
  previewKey?: string;

  @ApiProperty({
    description: "Processing time in milliseconds",
    example: 2500,
    required: false,
  })
  processingTime?: number;

  @ApiProperty({
    description: "Memory used during processing in MB",
    example: 45,
    required: false,
  })
  memoryUsed?: number;

  @ApiProperty({
    description: "Original file size in MB",
    example: 12.5,
    required: false,
  })
  originalFileSize?: number;

  @ApiProperty({
    description: "Whether the file was converted to WebP before processing",
    example: true,
    required: false,
  })
  convertedToWebp?: boolean;

  @ApiProperty({
    description: "File type detected from extension",
    example: "png",
    required: false,
  })
  fileType?: string;

  @ApiProperty({
    description: "File size threshold for processing (in MB)",
    example: 5,
    required: false,
  })
  threshold?: number;

  @ApiProperty({
    description: "File size in MB (for skipped files)",
    example: 2.3,
    required: false,
  })
  fileSize?: number;
}
