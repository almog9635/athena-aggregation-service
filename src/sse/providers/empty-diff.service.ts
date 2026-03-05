import { Injectable } from '@nestjs/common';
import { DiffService, DiffEntityResult } from '../types/diff';
import { DataGroup } from '../types/dataGroup';

@Injectable()
export class EmptyDiffService extends DiffService {
  getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, Record<string, number>>,
    dataGroup?: DataGroup,
  ): DiffEntityResult[] {
    // placeholder used when no real implementation is bound.
    // In production another provider should be registered that overrides this.
    return [];
  }
}
