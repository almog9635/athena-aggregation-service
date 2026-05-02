import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IDataSource } from '../interfaces/datasource.interface';

export interface MockEntity {
    id: string;
    name: string; // The GraphQL Typename / Entity Name
    version: number;
    days?: string[];
    [key: string]: any;
}

@Injectable()
export class MockDataGeneratorService implements IDataSource<any>, OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('MockDatabase');
    
    // Internal state representing your fake database: Map<EntityName, Map<ID, Entity>>
    private database = new Map<string, Map<string, MockEntity>>();
    private simInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.generateInitialData();
        this.startSimulation();
    }

    onModuleInit() {
        // Kept for interface compliance, but started in constructor
    }

    onModuleDestroy() {
        if (this.simInterval) {
            clearInterval(this.simInterval);
        }
    }

    private generateInitialData() {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // --- USERS ---
        const users = new Map<string, MockEntity>();
        users.set('u1', { id: 'u1', name: 'User', version: 1, email: 'pilot1@squad.com', role: 'Pilot', status: 'Active', days: [today] });
        users.set('u2', { id: 'u2', name: 'User', version: 1, email: 'pilot2@squad.com', role: 'Pilot', status: 'Resting', days: [today] });
        users.set('u3', { id: 'u3', name: 'User', version: 1, email: 'cmd@squad.com', role: 'Commander', status: 'Active', days: [today] });
        this.database.set('User', users);

        // --- MISSIONS ---
        const missions = new Map<string, MockEntity>();
        missions.set('m1', { id: 'm1', name: 'Mission', version: 1, target: 'Grid A', commanderId: 'u3', pilots: ['u1'], days: [today] });
        missions.set('m2', { id: 'm2', name: 'Mission', version: 1, target: 'Grid B', commanderId: 'u3', pilots: ['u2'], days: [today] });
        missions.set('m3', { id: 'm3', name: 'Mission', version: 1, target: 'Grid C', commanderId: 'u3', pilots: ['u1', 'u2'], days: [yesterday] });
        this.database.set('Mission', missions);
    }

    /**
     * Periodically changes random fields and increments the version number.
     * Your CachePollingService will detect these version bumps!
     */
    public startSimulation() {
        this.logger.log('Starting automated database updates & creation... (Changes every 8s)');
        
        let missionCounter = 4; // Start at 4 since we have m1, m2, m3
        let userCounter = 4;    // Start at 4 since we have u1, u2, u3

        this.simInterval = setInterval(() => {
            const entities = ['User', 'Mission'];
            const randomType = entities[Math.floor(Math.random() * entities.length)];
            const table = this.database.get(randomType);
            
            if (!table) return;

            // 30% chance to CREATE a new entity, 70% chance to UPDATE an existing one
            const isCreation = Math.random() < 0.3;

            if (isCreation) {
                const today = new Date().toISOString().split('T')[0];

                if (randomType === 'User') {
                    const newId = `u${userCounter++}`;
                    const roles = ['Pilot', 'Navigator', 'Engineer', 'Commander'];
                    const statuses = ['Active', 'Resting', 'In Briefing'];
                    
                    const newUser: MockEntity = {
                        id: newId,
                        name: 'User',
                        version: 1,
                        email: `new_user${newId}@squad.com`,
                        role: roles[Math.floor(Math.random() * roles.length)],
                        status: statuses[Math.floor(Math.random() * statuses.length)],
                        days: [today],
                    };
                    table.set(newId, newUser);
                    this.logger.debug(`[MOCK DB] ➕ CREATED new User ${newId} (${newUser.role})`);
                } else if (randomType === 'Mission') {
                    const newId = `m${missionCounter++}`;
                    const grids = ['Grid Delta', 'Grid Echo', 'Sector 9', 'Deep Space'];
                    
                    // Assign to random existing users if possible
                    const userTable = this.database.get('User');
                    const allUserIds = userTable ? Array.from(userTable.keys()) : ['u1'];
                    const randomCommanderId = allUserIds[Math.floor(Math.random() * allUserIds.length)];

                    const newMission: MockEntity = {
                        id: newId,
                        name: 'Mission',
                        version: 1,
                        target: grids[Math.floor(Math.random() * grids.length)],
                        commanderId: randomCommanderId,
                        pilots: [allUserIds[Math.floor(Math.random() * allUserIds.length)]],
                        days: [today],
                    };
                    table.set(newId, newMission);
                    this.logger.debug(`[MOCK DB] ➕ CREATED new Mission ${newId} (Target: ${newMission.target})`);
                }
            } else {
                // UPDATE EXISTING
                if (table.size > 0) {
                    const keys = Array.from(table.keys());
                    const randomId = keys[Math.floor(Math.random() * keys.length)];
                    const item = table.get(randomId);

                    if (item) {
                        item.version++;
                        
                        if (randomType === 'User') {
                            const statuses = ['Active', 'Resting', 'Deployed', 'In Briefing'];
                            item.status = statuses[Math.floor(Math.random() * statuses.length)];
                            this.logger.debug(`[MOCK DB] 🔄 UPDATED User ${item.id} status to '${item.status}' (v${item.version})`);
                        } else if (randomType === 'Mission') {
                            const grids = ['Grid Alpha', 'Grid Bravo', 'Grid Charlie', 'Sector 7G'];
                            item.target = grids[Math.floor(Math.random() * grids.length)];
                            this.logger.debug(`[MOCK DB] 🔄 UPDATED Mission ${item.id} target shifted to '${item.target}' (v${item.version})`);
                        }
                    }
                }
            }
        }, 8000); // Trigger an update every 8 seconds
    }

    // --- IDataSource Implementation ---

    async fetch(entityName: string, days?: string[], fields?: string[], filters?: Record<string, any>): Promise<MockEntity[]> {
        await this.delay(50); // Simulate network latency
        
        const table = this.database.get(entityName);
        if (!table) return [];

        let results = Array.from(table.values());

        // Deep clone so cache doesn't share memory references with the mock DB
        results = JSON.parse(JSON.stringify(results));

        // Filter by days
        if (days && days.length > 0) {
            results = results.filter(item => item.days?.some(d => days.includes(d)));
        }

        // Apply subscriber filters
        if (filters) {
            Object.entries(filters).forEach(([key, allowedValues]) => {
                if (Array.isArray(allowedValues)) {
                    results = results.filter(item => allowedValues.includes(item[key]));
                }
            });
        }

        // Return only requested fields
        if (fields && fields.length > 0) {
            return results.map(item => this.pickFields(item, fields));
        }

        return results;
    }

    async fetchByIds(entityName: string, ids: string[], days?: string[], fields?: string[], filters?: Record<string, any>): Promise<MockEntity[]> {
        await this.delay(20);
        
        const table = this.database.get(entityName);
        if (!table) return [];

        let results = ids.map(id => table.get(id)).filter(item => item !== undefined) as MockEntity[];
        
        // Deep clone so cache doesn't share memory references with the mock DB
        results = JSON.parse(JSON.stringify(results));
        
        if (fields && fields.length > 0) {
            return results.map(item => this.pickFields(item, fields));
        }

        return results;
    }

    async fetchAll(days?: string[]): Promise<MockEntity[]> {
        await this.delay(100);
        let results: MockEntity[] = [];

        // Flatten all tables into a single list
        for (const table of this.database.values()) {
            results.push(...Array.from(table.values()));
        }

        // Deep clone so cache doesn't share memory references with the mock DB
        results = JSON.parse(JSON.stringify(results));

        if (days && days.length > 0) {
            results = results.filter(item => item.days?.some(d => days.includes(d)));
        }
        
        return results;
    }

    private pickFields(item: MockEntity, fields: string[]): MockEntity {
        // ID, Name, Version, and Days are mandatory for the cache to function
        const baseFields = ['id', 'name', 'version', 'days'];
        const allFieldsToKeep = new Set([...baseFields, ...fields]);
        
        const filteredItem: any = {};
        for (const [key, value] of Object.entries(item)) {
            if (allFieldsToKeep.has(key)) {
                filteredItem[key] = value;
            }
        }
        return filteredItem as MockEntity;
    }

    private delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
