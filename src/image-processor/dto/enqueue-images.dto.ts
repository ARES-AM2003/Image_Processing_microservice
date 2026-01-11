import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsArray, ArrayNotEmpty } from "class-validator";

export class EnqueueImagesDto {
  @ApiProperty({
    description: "Name of the S3 bucket where images are stored",
    example: "my-s3-bucket-name",
  })
  @IsString()
  bucket: string;

  @ApiProperty({
    description: "Array of file keys in the bucket to enqueue",
    example: [
      "images/photo1.jpg",
      "images/photo2.png",
      "images/photo3.webp",
      "images/IMG_001.heic",
      "camera/DSC_001.nef",
      "raw/photo.cr2",
    ],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  keys: string[];
}
