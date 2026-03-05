import { SessionRegistryService } from './session-registry.service';
import { Session } from './types/session';

describe('SessionRegistryService', () => {
  let service: SessionRegistryService;

  beforeEach(() => {
    service = new SessionRegistryService();
  });

  it('should add and remove sessions', () => {
    const session: Session = {
      sessionId: 'a',
      userId: 'u1',
      squadronIds: ['s1'],
      startDate: '2020-01-01',
      endDate: '2020-01-07',
      response: null,
      createdAt: Date.now(),
    };
    service.add(session);
    expect(service.countSessions()).toBe(1);
    expect(service.findById('a')).toBe(session);
    service.remove(session);
    expect(service.countSessions()).toBe(0);
    expect(service.findById('a')).toBeUndefined();
  });
});
