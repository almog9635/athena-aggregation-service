import { Module, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SseController } from './sse.controller';
import { SseService } from './sse.service';
import { SessionRegistryService } from './session-registry.service';
import { EmptyDiffService } from './providers/empty-diff.service';

@Module({
  imports: [ConfigModule],
  controllers: [SseController],
  providers: [SseService, SessionRegistryService, EmptyDiffService],
  exports: [SseService],
})
export class SseModule {
  // this module expects a provider for DiffService to be registered
  static withDiffProvider(diffProvider: any): DynamicModule {
    return {
      module: SseModule,
      providers: [diffProvider],
      exports: [diffProvider],
    };
  }
}
