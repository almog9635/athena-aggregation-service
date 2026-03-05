import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { GraphQLStitchingModule } from './graphql/graphql-stitching.module';
import { CacheManagerModule } from './cache-manager/cache-manager.module';
import { SseModule } from './sse/sse.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true, // Make configuration accessible everywhere
    }),
    GraphQLStitchingModule,
    CacheManagerModule,
    SseModule, // real app should provide its own diff service via SseModule.withDiffProvider
  ],
  controllers: [AppController],
  providers: [AppService],
  exports: [],
})
export class AppModule { }
