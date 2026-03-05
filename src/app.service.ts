import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Athena Aggregation Service API is running! Frontend is at localhost:4200';
  }
}
