import {
  IsISO8601,
  IsOptional,
  IsString,
  IsArray,
  ArrayNotEmpty,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class EventsQueryDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  squadronIds: string[];

  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'object') {
      return value as Record<string, number>;
    }
    try {
      return JSON.parse(value) as Record<string, number>;
    } catch {
      return undefined;
    }
  })
  entityVersions?: Record<string, number>;
}
