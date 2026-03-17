export interface DiffEntityResult {
  entityName: string;
  entityId: string;
  version: number;
  data: unknown;
}

export abstract class DiffService {
  abstract getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, Record<string, number>>,
    dataGroup?: string,
  ): Promise<DiffEntityResult[]>;
}
