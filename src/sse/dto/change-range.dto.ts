import { IsISO8601, IsNotEmpty, IsString } from 'class-validator';

export class ChangeRangeDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsISO8601()
  @IsNotEmpty()
  startDate: string;

  @IsISO8601()
  @IsNotEmpty()
  endDate: string;
}
