import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SseModule } from './sse/sse.module';
import { EmptyDiffService } from './sse/providers/empty-diff.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SseModule, // real app should provide its own diff service via SseModule.withDiffProvider
  ],
  controllers: [AppController],
  providers: [AppService, EmptyDiffService],
  exports: [],
})
export class AppModule {}
