export interface BaseEntityData {
  dataGroup: string;
  deleted?: boolean;
  [key: string]: any;
}

export interface WeeklyEntityData extends BaseEntityData {
  title: string;
  description: string;
  status: string;
  date: string;
  importance: string;
}

export interface EventAData extends BaseEntityData {
  title: string;
  priority: string;
  location: string;
  staffCount: number;
}

export interface EventBData extends BaseEntityData {
  title: string;
  category: string;
  impact: string;
  delay: string;
}

export type EntityData = WeeklyEntityData | EventAData | EventBData | BaseEntityData;

export interface DiffEntityResult {
  entityName: string;
  entityId: string;
  version: number;
  data: EntityData;
}

export abstract class DiffService {
  abstract getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, Record<string, number>>,
    dataGroup?: string,
  ): DiffEntityResult[];
}
