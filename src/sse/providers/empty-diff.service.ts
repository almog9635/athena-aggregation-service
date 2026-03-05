import { Injectable } from '@nestjs/common';
import { DiffService, DiffEntityResult } from '../types/diff';

@Injectable()
export class EmptyDiffService extends DiffService {
  getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, Record<string, number>>,
    dataGroup?: string,
  ): DiffEntityResult[] {
    // placeholder used when no real implementation is bound.
    // In production another provider should be registered that overrides this.
    return [];
  }
}
