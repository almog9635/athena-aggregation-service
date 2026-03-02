export interface DiffEntityResult {
  entityName: string;
  version: number;
  data: unknown;
}

export abstract class DiffService {
  abstract getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, number>,
  ): DiffEntityResult[];
}
