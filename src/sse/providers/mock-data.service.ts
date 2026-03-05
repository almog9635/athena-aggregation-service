import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Subject } from 'rxjs';
import { DiffEntityResult, DiffService, EntityData, WeeklyEntityData, EventAData, EventBData } from '../types/diff';
import { DataGroup } from '../types/dataGroup';

@Injectable()
export class MockDataService extends DiffService implements OnModuleInit {
  private readonly logger = new Logger(MockDataService.name);
  private entities: DiffEntityResult[] = [];
  private extraDetails: Record<string, any> = {};

  private readonly updateSubject = new Subject<DiffEntityResult[]>();
  public readonly updates$ = this.updateSubject.asObservable();

  onModuleInit() {
    this.initializeMockData();
    this.startGenerator();
  }

  private initializeMockData() {
    const now = new Date();
    
    // Weekly events - generate more density
    const weekTitles = ['Weekly Sync', 'Tech Review', 'Planning Session', 'Status Update', 'Retrospective', 'Stakeholder Meeting', 'Workshop'];
    const weekDescriptions = ['Discussing project progress and blockers', 'Reviewing technical debt and architecture', 'Finalizing sprints and resources', 'General status update for all teams', 'Analyzing previous performance'];

    for (let i = -2; i <= 2; i++) {
        const baseDate = new Date();
        baseDate.setDate(now.getDate() + (i * 7));
        
        // Loop through days of the specific week
        for (let d = 0; d < 7; d++) {
            const currentDayDate = new Date(baseDate);
            currentDayDate.setDate(baseDate.getDate() + d);
            
            // Add 2-3 events per day
            const eventsPerDay = 2 + Math.floor(Math.random() * 2);
            for (let e = 0; e < eventsPerDay; e++) {
                const eventTime = new Date(currentDayDate);
                eventTime.setHours(9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60));

                this.addEntity('week', {
                    title: weekTitles[Math.floor(Math.random() * weekTitles.length)],
                    description: weekDescriptions[Math.floor(Math.random() * weekDescriptions.length)],
                    status: i < 0 ? 'Completed' : i === 0 ? (Math.random() > 0.5 ? 'In Progress' : 'Scheduled') : 'Scheduled',
                    date: eventTime.toISOString(),
                    importance: Math.random() > 0.7 ? 'High' : 'Normal',
                });
            }
        }
    }

    // Event A data
    this.addEntity('eventA', {
        title: 'Emergency Drill',
        priority: 'Critical',
        location: 'Base Alpha',
        staffCount: 15,
    });

    // Event B data
    this.addEntity('eventB', {
        title: 'Supply Re-route',
        category: 'Logistics',
        impact: 'Moderate',
        delay: '2 hours',
    });
  }

  private addEntity(group: string, data: Partial<EntityData>) {
    const id = uuidv4();
    const entity: DiffEntityResult = {
      entityName: `${group}_${id.substring(0, 8)}`,
      entityId: id,
      version: 1,
      data: { ...data, dataGroup: group },
    };
    this.entities.push(entity);
    
    // Store extra details
    this.extraDetails[id] = {
        extendedDescription: `More detailed information about ${group} entity ${id}. This includes historical logs, related personnel, and specific technical specifications.`,
        createdat: new Date().toISOString(),
        systemTags: [group, 'mock', 'automated'],
        riskAssessment: group === 'eventA' ? 'High' : 'Low',
        internalNotes: 'Automated generation for testing purposes.'
    };

    return entity;
  }

  getDiff(
    squadronIds: string[],
    startDate: string,
    endDate: string,
    entityVersions?: Record<string, Record<string, number>>,
    dataGroup?: string,
  ): DiffEntityResult[] {
    return this.entities.filter(e => {
        const entityData = e.data;
        if (dataGroup && entityData.dataGroup !== dataGroup) return false;
        
        // For 'week', check date range if dates are provided
        if (entityData.dataGroup === 'week') {
            const weekData = entityData as WeeklyEntityData;
            if (weekData.date) {
                const eDate = new Date(weekData.date);
                if (startDate && eDate < new Date(startDate)) return false;
                if (endDate && eDate > new Date(endDate)) return false;
            }
        }
        
        return true;
    });
  }

  getExtraDetails(id: string) {
      const entity = this.entities.find(e => e.entityId === id);
      if (!entity) return null;
      
      return {
          ...entity,
          extra: this.extraDetails[id] || {}
      };
  }

  private startGenerator() {
    setInterval(() => {
        const action = Math.random();
        if (action < 0.2) {
            // Add new
            const groups = ['eventA', 'eventB', 'week'];
            const group = groups[Math.floor(Math.random() * groups.length)];
            const newEntity = this.addEntity(group, {
                title: `New ${group} Entity`,
                dynamicField: Math.random().toFixed(2),
                timestamp: new Date().toISOString(),
            });
            this.logger.log(`Generated new entity: ${newEntity.entityName}`);
            this.updateSubject.next([newEntity]);
        } else if (action < 0.7 && this.entities.length > 0) {
            // Update existing
            const index = Math.floor(Math.random() * this.entities.length);
            const entity = this.entities[index];
            entity.version++;
            const data = entity.data;
            data.lastUpdate = new Date().toISOString();
            data.randomValue = Math.floor(Math.random() * 100);
            this.logger.log(`Updated entity: ${entity.entityName} to version ${entity.version}`);
            this.updateSubject.next([entity]);
        } else if (action < 0.8 && this.entities.length > 5) {
            // Remove (keeping at least 5)
            const index = Math.floor(Math.random() * this.entities.length);
            const entity = this.entities.splice(index, 1)[0];
            this.logger.log(`Removed entity: ${entity.entityName}`);
            // For removal, we could send a special payload or just let it time out on client.
            // Let's send it with a 'deleted' flag.
            this.updateSubject.next([{ ...entity, data: { ...entity.data, deleted: true } }]);
        }
    }, 10000); // Every 10 seconds
  }

  getAllEntities() {
      return this.entities;
  }
}
