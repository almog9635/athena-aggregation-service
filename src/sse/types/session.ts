import { Response } from 'express';

export interface Session {
  sessionId: string;
  userId: string;
  squadronIds: string[];
  startDate: string;
  endDate: string;
  response: Response | null;
  createdAt: number;
  heartbeatTimer?: ReturnType<typeof setTimeout> | null;
}
