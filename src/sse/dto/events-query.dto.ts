import {
  IsISO8601,
  IsOptional,
  IsString,
  IsArray,
  ArrayNotEmpty,
  IsEnum,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { dataGroup, type DataGroup } from '../types/dataGroup';

export class EventsQueryDto {
  @IsString()
  userId: string;

  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return [value];
    }
    return value;
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  squadronIds: string[];

  @IsEnum(dataGroup)
  @IsOptional()
  dataGroup?: DataGroup;

  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'object') {
      return value as Record<string, Record<string, number>>;
    }
    try {
      return JSON.parse(value) as Record<string, Record<string, number>>;
    } catch {
      return undefined;
    }
  })
  entityVersions?: Record<string, Record<string, number>>;
}
