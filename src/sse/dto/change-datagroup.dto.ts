import { IsString, IsNotEmpty } from 'class-validator';

export class ChangeDataGroupDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  dataGroup: string;
}
