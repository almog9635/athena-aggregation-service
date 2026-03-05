import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { dataGroup, type DataGroup } from '../types/dataGroup';

export class ChangeDataGroupDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsNotEmpty()
  @IsIn(Object.values(dataGroup))
  dataGroup: DataGroup;
}
